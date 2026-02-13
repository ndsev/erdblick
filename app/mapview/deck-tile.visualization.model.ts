import {FeatureTile} from "../mapdata/features.model";
import {FeatureLayerStyle, HighlightMode} from "../../build/libs/core/erdblick-core";
import {ITileVisualization, IRenderSceneHandle} from "./render-view.model";
import {PathLayer} from "@deck.gl/layers";
import {DeckLayerRegistry, makeDeckLayerKey} from "./deck-layer-registry";
import {coreLib} from "../integrations/wasm";

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
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                boxGrid?: boolean,
                options?: Record<string, boolean | number | string>) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
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
        const pathLayerKey = makeDeckLayerKey({
            tileKey: this.tile.mapTileKey,
            styleId: this.styleId,
            hoverMode: this.highlightModeLabel(),
            kind: "path"
        });
        const pathData = await this.extractPathData();
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

    setStyleOption(optionId: string, value: string | number | boolean): void {
        this.options[optionId] = value;
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
        if (typeof this.tile.peekAsync !== "function") {
            return [];
        }
        if (typeof this.tile.hasData === "function" && !this.tile.hasData()) {
            return [];
        }
        if (typeof (coreLib as any).DeckFeatureLayerVisualization !== "function") {
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
            const positions = this.asNumberArray(deckVisu.pathPositions());
            const startIndices = this.asNumberArray(deckVisu.pathStartIndices());
            const colors = this.asNumberArray(deckVisu.pathColors());
            const widths = this.asNumberArray(deckVisu.pathWidths());
            if (positions.length === 0 || startIndices.length < 2) {
                return [];
            }

            const paths: DeckPathData[] = [];
            for (let pathIndex = 0; pathIndex < startIndices.length - 1; pathIndex++) {
                const start = startIndices[pathIndex];
                const end = startIndices[pathIndex + 1];
                if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2) {
                    continue;
                }

                const path: [number, number, number][] = [];
                for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                    const offset = vertexIndex * 3;
                    const lon = positions[offset];
                    const lat = positions[offset + 1];
                    const alt = positions[offset + 2] ?? 0;
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
                    this.clampByte(colors[colorOffset] ?? 32),
                    this.clampByte(colors[colorOffset + 1] ?? 196),
                    this.clampByte(colors[colorOffset + 2] ?? 255),
                    this.clampByte(colors[colorOffset + 3] ?? 220)
                ];
                const width = Math.max(1, Number(widths[pathIndex] ?? 2));
                paths.push({path, color, width});
            }
            return paths;
        } catch (e) {
            console.error(`[deck] extractPathData failed @${stage} for ${this.tile.mapTileKey}:`, e);
            return [];
        } finally {
            if (deckVisu && typeof deckVisu.delete === "function") {
                deckVisu.delete();
            }
        }
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

    private resolveRegistry(sceneHandle: IRenderSceneHandle): DeckLayerRegistry | undefined {
        if (sceneHandle.renderer !== "deck") {
            return undefined;
        }
        const scene = sceneHandle.scene as DeckSceneHandle;
        return scene.layerRegistry;
    }
}
