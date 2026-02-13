import {FeatureTile} from "../../mapdata/features.model";
import {FeatureLayerStyle, HighlightMode} from "../../../build/libs/core/erdblick-core";
import {ITileVisualization, IRenderSceneHandle} from "../render-view.model";
import {PathLayer} from "@deck.gl/layers";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, uint8ArrayFromWasm} from "../../integrations/wasm";
import {deckRenderWorkerPool} from "./deck-render.worker.pool";

const ENABLE_DECK_WORKER_POOL = false;

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
    startIndices: Uint32Array;
    attributes: {
        getPath: DeckBinaryAttribute<Float32Array>;
        instanceColors: DeckBinaryAttribute<Uint8Array>;
        instanceStrokeWidths: DeckBinaryAttribute<Float32Array>;
    };
}

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
    private readonly options: Record<string, boolean | number | string>;
    private renderQueued = false;
    private deleted = false;
    private rendered = false;
    private pathLayerKey: string | null = null;
    private lastSignature = "";
    private hadTileDataAtLastRender = false;
    private tileFeatureCountAtLastRender = 0;

    constructor(viewIndex: number,
                tile: FeatureTile,
                style: FeatureLayerStyle,
                styleSource: string,
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                boxGrid?: boolean,
                options?: Record<string, boolean | number | string>) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.styleSource = styleSource;
        this.styleId = this.style.name();
        this.isHighDetail = highDetail;
        this.highlightMode = highlightMode;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.viewIndex = viewIndex;
    }

    async render(sceneHandle: IRenderSceneHandle): Promise<boolean> {
        const registry = this.resolveRegistry(sceneHandle);
        if (this.deleted || this.style.isDeleted()) {
            return false;
        }
        const startTime = performance.now();
        const pathLayerKey = makeDeckLayerKey({
            tileKey: this.tile.mapTileKey,
            styleId: this.styleId,
            hoverMode: this.highlightModeLabel(),
            kind: "path"
        });
        try {
            const pathLayerData = await this.extractPathData();
            if (this.deleted || this.style.isDeleted()) {
                return false;
            }
            if (pathLayerData && pathLayerData.length > 0) {
                const pathLayer = new PathLayer({
                    id: pathLayerKey,
                    data: pathLayerData as any,
                    _pathType: "open",
                    widthUnits: "pixels",
                    capRounded: true,
                    jointRounded: true,
                    pickable: false
                });
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
            this.recordRenderTimeSample(performance.now() - startTime);
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
            styleOptions: this.options
        });
    }

    private async extractPathData(): Promise<DeckPathLayerData | null> {
        if (ENABLE_DECK_WORKER_POOL) {
            const workerResult = await this.extractPathDataInWorker();
            if (workerResult) {
                return workerResult;
            }
        }
        return await this.extractPathDataOnMainThread();
    }

    private async extractPathDataInWorker(): Promise<DeckPathLayerData | null> {
        const tileWithParserContext = this.tile as FeatureTile & {
            getFieldDictBlob?: () => Uint8Array | null;
            getDataSourceInfoBlob?: () => Uint8Array | null;
        };
        const pool = deckRenderWorkerPool();
        const result = await pool.renderPaths({
            viewIndex: this.viewIndex,
            tileKey: this.tile.mapTileKey,
            tileBlob: this.tile.tileFeatureLayerBlob as Uint8Array,
            fieldDictBlob: tileWithParserContext.getFieldDictBlob!() as Uint8Array,
            dataSourceInfoBlob: tileWithParserContext.getDataSourceInfoBlob!() as Uint8Array,
            nodeId: this.tile.nodeId,
            mapName: this.tile.mapName,
            styleSource: this.styleSource,
            styleOptions: this.copyStyleOptions(),
            highlightModeValue: this.highlightMode.value
        });
        return this.buildPathLayerData(
            result.positions,
            result.startIndices,
            result.colors,
            result.widths
        );
    }

    private async extractPathDataOnMainThread(): Promise<DeckPathLayerData | null> {
        let deckVisu: any;
        try {
            deckVisu = new (coreLib as any).DeckFeatureLayerVisualization(
                this.viewIndex,
                this.tile.mapTileKey,
                this.style,
                this.options,
                this.highlightMode,
                []
            );

            await this.tile.peekAsync(async (tileFeatureLayer) => {
                deckVisu.addTileFeatureLayer(tileFeatureLayer);
                deckVisu.run();
            });

            const positions = this.readFloat32Array(deckVisu, "pathPositionsRaw");
            const startIndices = this.readUint32Array(deckVisu, "pathStartIndicesRaw");
            const colors = this.readUint8Array(deckVisu, "pathColorsRaw");
            const widths = this.readFloat32Array(deckVisu, "pathWidthsRaw");
            return this.buildPathLayerData(positions, startIndices, colors, widths);
        } finally {
            if (deckVisu && typeof deckVisu.delete === "function") {
                deckVisu.delete();
            }
        }
    }

    private buildPathLayerData(
        positions: Float32Array,
        startIndices: Uint32Array,
        colors: Uint8Array,
        widths: Float32Array
    ): DeckPathLayerData | null {
        const pathCount = startIndices.length - 1;
        if (!pathCount) {
            return null;
        }

        const vertexCount = startIndices[pathCount];
        if (vertexCount <= 1) {
            return null;
        }

        const instanceColors = new Uint8Array(vertexCount * 4);
        const instanceStrokeWidths = new Float32Array(vertexCount);
        for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
            const start = startIndices[pathIndex];
            const end = startIndices[pathIndex + 1];
            const colorOffset = pathIndex * 4;
            const r = colors[colorOffset];
            const g = colors[colorOffset + 1];
            const b = colors[colorOffset + 2];
            const a = colors[colorOffset + 3];
            const width = widths[pathIndex];
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const instanceColorOffset = vertexIndex * 4;
                instanceColors[instanceColorOffset] = r;
                instanceColors[instanceColorOffset + 1] = g;
                instanceColors[instanceColorOffset + 2] = b;
                instanceColors[instanceColorOffset + 3] = a;
                instanceStrokeWidths[vertexIndex] = width;
            }
        }

        return {
            length: pathCount,
            startIndices,
            attributes: {
                getPath: {value: positions, size: 3},
                instanceColors: {value: instanceColors, size: 4},
                instanceStrokeWidths: {value: instanceStrokeWidths, size: 1}
            }
        };
    }

    private readFloat32Array(deckVisu: any, rawAccessor: string): Float32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
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

    private recordRenderTimeSample(durationMs: number): void {
        const tileWithStats = this.tile as unknown as { stats: Map<string, number[]> };
        const timingListKey = `Rendering/${this.statsHighlightModeLabel()}/${this.styleId}#ms`;
        const timingList = tileWithStats.stats.get(timingListKey);
        if (timingList) {
            timingList.push(durationMs);
            return;
        }
        tileWithStats.stats.set(timingListKey, [durationMs]);
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
}
