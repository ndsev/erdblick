import {FeatureTile} from "../mapdata/features.model";
import {FeatureLayerStyle, HighlightMode} from "../../build/libs/core/erdblick-core";
import {ITileVisualization, IRenderSceneHandle} from "./render-view.model";
import {PathLayer} from "@deck.gl/layers";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm";
import {deckRenderWorkerPool} from "./deck-render.worker.pool";

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
}

interface DeckSceneHandle {
    deck?: unknown;
    layerRegistry?: DeckLayerRegistry;
}

interface DeckPathData {
    path: [number, number, number][];
    color: [number, number, number, number];
    width: number;
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
        if (!registry || this.deleted || this.style.isDeleted()) {
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
            const pathData = await this.extractPathData();
            if (this.deleted || this.style.isDeleted()) {
                return false;
            }
            if (pathData.length > 0) {
                const pathLayer = new PathLayer({
                    id: pathLayerKey,
                    data: pathData,
                    getPath: (d: DeckPathData) => d.path,
                    getColor: (d: DeckPathData) => d.color,
                    getWidth: (d: DeckPathData) => d.width,
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
        if (registry && this.pathLayerKey) {
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

    private async extractPathData(): Promise<DeckPathData[]> {
        if (typeof this.tile.hasData === "function" && !this.tile.hasData()) {
            return [];
        }
        if (typeof (coreLib as any).DeckFeatureLayerVisualization !== "function") {
            return [];
        }
        const workerResult = await this.extractPathDataInWorker();
        if (workerResult) {
            return workerResult;
        }
        return await this.extractPathDataOnMainThread();
    }

    private async extractPathDataInWorker(): Promise<DeckPathData[] | null> {
        const tileBlob = this.tile.tileFeatureLayerBlob;
        if (!tileBlob || !tileBlob.length) {
            return null;
        }
        if (!this.styleSource.length) {
            return null;
        }

        const tileWithParserContext = this.tile as FeatureTile & {
            getFieldDictBlob?: () => Uint8Array | null;
            getDataSourceInfoBlob?: () => Uint8Array | null;
        };
        if (typeof tileWithParserContext.getFieldDictBlob !== "function" ||
            typeof tileWithParserContext.getDataSourceInfoBlob !== "function") {
            return null;
        }
        const fieldDictBlob = tileWithParserContext.getFieldDictBlob();
        const dataSourceInfoBlob = tileWithParserContext.getDataSourceInfoBlob();
        if (!fieldDictBlob || !dataSourceInfoBlob) {
            return null;
        }

        const pool = deckRenderWorkerPool();
        if (!pool.isAvailable()) {
            return null;
        }
        try {
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
                highlightModeValue: this.highlightMode.value
            });
            return this.buildPathDataFromTypedArrays(
                result.positions,
                result.startIndices,
                result.colors,
                result.widths
            );
        } catch (err) {
            console.warn(`[deck] worker extraction fallback for ${this.tile.mapTileKey}:`, err);
            return null;
        }
    }

    private async extractPathDataOnMainThread(): Promise<DeckPathData[]> {
        if (typeof this.tile.peekAsync !== "function") {
            return [];
        }
        let deckVisu: any;
        let stage = "constructor";
        try {
            deckVisu = new (coreLib as any).DeckFeatureLayerVisualization(
                this.viewIndex,
                this.tile.mapTileKey,
                this.style,
                this.options,
                this.highlightMode,
                []
            );

            stage = "peekAsync";
            await this.tile.peekAsync(async (tileFeatureLayer) => {
                stage = "addTileFeatureLayer";
                deckVisu.addTileFeatureLayer(tileFeatureLayer);
                stage = "run";
                deckVisu.run();
            });

            stage = "accessors";
            const positions = this.readFloat32Array(deckVisu, "pathPositionsRaw", "pathPositions");
            const startIndices = this.readUint32Array(deckVisu, "pathStartIndicesRaw", "pathStartIndices");
            const colors = this.readUint8Array(deckVisu, "pathColorsRaw", "pathColors");
            const widths = this.readFloat32Array(deckVisu, "pathWidthsRaw", "pathWidths");
            return this.buildPathDataFromTypedArrays(positions, startIndices, colors, widths);
        } catch (e) {
            console.error(`[deck] extractPathData failed @${stage} for ${this.tile.mapTileKey}:`, e);
            return [];
        } finally {
            if (deckVisu && typeof deckVisu.delete === "function") {
                deckVisu.delete();
            }
        }
    }

    private buildPathDataFromTypedArrays(
        positions: ArrayLike<number>,
        startIndices: ArrayLike<number>,
        colors: ArrayLike<number>,
        widths: ArrayLike<number>
    ): DeckPathData[] {
        if (positions.length === 0 || startIndices.length < 2) {
            return [];
        }
        const paths: DeckPathData[] = [];
        for (let pathIndex = 0; pathIndex < startIndices.length - 1; pathIndex++) {
            const start = Number(startIndices[pathIndex]);
            const end = Number(startIndices[pathIndex + 1]);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2) {
                continue;
            }

            const path: [number, number, number][] = [];
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const offset = vertexIndex * 3;
                const lon = Number(positions[offset]);
                const lat = Number(positions[offset + 1]);
                const alt = Number(positions[offset + 2] ?? 0);
                if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(alt)) {
                    continue;
                }
                path.push([lon, lat, alt]);
            }
            if (path.length < 2) {
                continue;
            }

            const colorOffset = pathIndex * 4;
            const color: [number, number, number, number] = [
                this.clampByte(Number(colors[colorOffset] ?? 32)),
                this.clampByte(Number(colors[colorOffset + 1] ?? 196)),
                this.clampByte(Number(colors[colorOffset + 2] ?? 255)),
                this.clampByte(Number(colors[colorOffset + 3] ?? 220))
            ];
            const width = Math.max(1, Number(widths[pathIndex] ?? 2));
            paths.push({path, color, width});
        }
        return paths;
    }

    private readFloat32Array(deckVisu: any, rawAccessor: string, legacyAccessor: string): Float32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        if (raw) {
            if (raw.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
                console.warn(`[deck] ${rawAccessor} returned invalid byte length ${raw.byteLength}`);
                return new Float32Array();
            }
            if (raw.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
                return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
            }
            const aligned = new Uint8Array(raw);
            return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT);
        }
        return Float32Array.from(this.asNumberArray(this.callAccessor(deckVisu, legacyAccessor)));
    }

    private readUint32Array(deckVisu: any, rawAccessor: string, legacyAccessor: string): Uint32Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        if (raw) {
            if (raw.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
                console.warn(`[deck] ${rawAccessor} returned invalid byte length ${raw.byteLength}`);
                return new Uint32Array();
            }
            if (raw.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0) {
                return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / Uint32Array.BYTES_PER_ELEMENT);
            }
            const aligned = new Uint8Array(raw);
            return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Uint32Array.BYTES_PER_ELEMENT);
        }
        return Uint32Array.from(this.asNumberArray(this.callAccessor(deckVisu, legacyAccessor)));
    }

    private readUint8Array(deckVisu: any, rawAccessor: string, legacyAccessor: string): Uint8Array {
        const raw = this.readRawBytes(deckVisu, rawAccessor);
        if (raw) {
            return raw;
        }
        return Uint8Array.from(this.asNumberArray(this.callAccessor(deckVisu, legacyAccessor)));
    }

    private readRawBytes(deckVisu: any, rawAccessor: string): Uint8Array | null {
        if (!deckVisu || typeof deckVisu[rawAccessor] !== "function") {
            return null;
        }
        try {
            return uint8ArrayFromWasm((shared) => {
                deckVisu[rawAccessor](shared);
                return true;
            }) ?? new Uint8Array();
        } catch (e) {
            console.warn(`[deck] failed to read raw accessor ${rawAccessor}:`, e);
            return null;
        }
    }

    private callAccessor(deckVisu: any, accessorName: string): unknown {
        if (!deckVisu || typeof deckVisu[accessorName] !== "function") {
            return [];
        }
        return deckVisu[accessorName]();
    }

    private asNumberArray(raw: unknown): number[] {
        if (!raw) {
            return [];
        }
        if (ArrayBuffer.isView(raw)) {
            return Array.from(raw as unknown as number[]);
        }
        if (Array.isArray(raw)) {
            return raw.map((value) => Number(value));
        }
        return [];
    }

    private clampByte(value: number): number {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    private tileHasData(): boolean {
        if (typeof this.tile.hasData === "function") {
            return this.tile.hasData();
        }
        return this.tileFeatureCount() > 0;
    }

    private tileFeatureCount(): number {
        const value = Number((this.tile as any).numFeatures ?? 0);
        return Number.isFinite(value) ? value : 0;
    }

    private copyStyleOptions(): Record<string, boolean | number | string> {
        return {...this.options};
    }

    private recordRenderTimeSample(durationMs: number): void {
        if (!Number.isFinite(durationMs)) {
            return;
        }
        const tileWithStats = this.tile as unknown as { stats?: Map<string, number[]> };
        if (!(tileWithStats.stats instanceof Map)) {
            tileWithStats.stats = new Map<string, number[]>();
        }
        const timingListKey = `Rendering/${this.statsHighlightModeLabel()}/${this.styleId}#ms`;
        const timingList = tileWithStats.stats.get(timingListKey) ?? [];
        timingList.push(durationMs);
        tileWithStats.stats.set(timingListKey, timingList);
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

    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry | undefined {
        if (sceneHandle.renderer !== "deck") {
            return undefined;
        }
        const scene = sceneHandle.scene as DeckSceneHandle;
        return scene.layerRegistry;
    }
}
