import { COORDINATE_SYSTEM } from "@deck.gl/core";
import type { Viewport } from "../../../build/libs/core/erdblick-core";
import { coreLib } from "../../integrations/wasm.adapter";
import type { TileGridMode } from "../mapview.model";
import {
    autoTileGridLevel,
    coarsenedTileLevel,
    tileGridExtentForLevel,
    tileGridLatToNormY,
    type TileGridLevelExtent,
    tileGridLonToNormX,
    tileGridVisibleCellCount,
    wrapColumnIntoExtent
} from "../tile-grid-visibility.util";
import type { DeckLayerRegistry } from "./deck-layer-registry.util";
import { DECK_OVERLAY_PARAMETERS } from "./deck-overlay.constants";
import { createRectangleOverlayLayer, rectangleOverlayData } from "./deck-rectangle-overlay.layer";
import {
    TILE_STATE_KIND_EMPTY,
    TILE_STATE_KIND_ERROR,
    tileGridOverlayData,
    type TileGridOverlayDatum,
    TileGridOverlayLayer,
    TileGridStateOverlayLayer
} from "./deck-tile-grid-overlay.layer";

/** Geometry description for one tile-grid overlay level after local normalization. */
interface TileGridOverlayGeometry {
    data: TileGridOverlayDatum[];
    localMin: [number, number];
    localSize: [number, number];
    subdivisionX: number;
    subdivisionY: number;
}

/** Map/layer pair used when aggregating tile-state overlays per visible feature level. */
interface VisibleLayerRef {
    mapId: string;
    layerId: string;
}
/** Current view inputs, read only when a coalesced grid refresh actually runs. */
export interface DeckTileOverlayFrame {
    viewport: Viewport;
    mode: TileGridMode;
    level: number;
    autoLevel: boolean;
    lineColor: [number, number, number, number];
    altitude: number;
    tileLimit: number;
    layers: readonly (VisibleLayerRef & {level: number})[];
}

/** Owns grid geometry, occupancy coloring, outlines and their scheduled work for one canvas. */
export class DeckTileOverlay {

    private static readonly TILE_GRID_LAYER_KEY = "builtin/tile-grid";
    private static readonly TILE_STATE_LAYER_KEY = "builtin/tile-state";
    private static readonly TILE_OUTLINE_LAYER_KEY = "builtin/tile-outline";
    private static readonly TILE_GRID_LINE_WIDTH_PX = 1.0;
    private static readonly TILE_GRID_MAX_VISIBLE_CELLS = 16 * 1024;
    private static readonly TILE_GRID_DATA_REFRESH_DEBOUNCE_MS = 250;
    private static readonly TILE_STATE_ERROR_COLOR: [number, number, number, number] = [225, 45, 45, 105];
    private static readonly TILE_STATE_EMPTY_COLOR: [number, number, number, number] = [122, 126, 133, 64];

    private tileGridLayerKeys = new Set<string>();
    private tileStateLayerKeys = new Set<string>();
    private tileGridOverlayUpdateRaf: number | null = null;
    private tileGridOverlayDataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private frame: DeckTileOverlayFrame | null = null;
    private destroyed = false;

    /** Accept a snapshot reader and bounded occupancy lookup, not map or tile controllers. */
    constructor(private readonly layerRegistry: DeckLayerRegistry,
                private readonly readFrame: () => DeckTileOverlayFrame | null,
                private readonly occupancyForTile: (tileId: number, layers: VisibleLayerRef[]) => string | null) {}

    /** Replace the context-menu outline from geographic data prepared at the application boundary. */
    setOutline(data: ReturnType<typeof rectangleOverlayData> | null): void {
        if (this.destroyed || !data?.length) this.layerRegistry.remove(DeckTileOverlay.TILE_OUTLINE_LAYER_KEY);
        else this.layerRegistry.upsert(DeckTileOverlay.TILE_OUTLINE_LAYER_KEY,
            createRectangleOverlayLayer(DeckTileOverlay.TILE_OUTLINE_LAYER_KEY, data), 520);
    }

    /** Cancel both refresh schedules before removing this owner's layers. */
    destroy(): void {
        this.destroyed = true;
        this.cancelScheduling();
        this.removeTileGridLayers();
        this.removeTileStateLayers();
        this.layerRegistry.remove(DeckTileOverlay.TILE_OUTLINE_LAYER_KEY);
        this.frame = null;
    }

    /** Schedules one tile-grid overlay refresh on the next animation frame. */
    scheduleUpdate(): void {
        if (this.destroyed || this.tileGridOverlayUpdateRaf !== null) {
            return;
        }
        this.tileGridOverlayUpdateRaf = requestAnimationFrame(() => {
            this.tileGridOverlayUpdateRaf = null;
            this.updateTileGridOverlay();
        });
    }

    /** Recolors tile state after a tile-arrival burst without redrawing the full scene per tile. */
    scheduleDataRefresh(enabled: boolean): void {
        if (this.destroyed || !enabled) {
            return;
        }
        if (this.tileGridOverlayDataRefreshTimer !== null) {
            clearTimeout(this.tileGridOverlayDataRefreshTimer);
        }
        this.tileGridOverlayDataRefreshTimer = setTimeout(() => {
            this.tileGridOverlayDataRefreshTimer = null;
            this.scheduleUpdate();
        }, DeckTileOverlay.TILE_GRID_DATA_REFRESH_DEBOUNCE_MS);
    }

    /** Cancels pending tile-grid overlay refresh work. */
    private cancelScheduling(): void {
        if (this.tileGridOverlayUpdateRaf !== null) {
            cancelAnimationFrame(this.tileGridOverlayUpdateRaf);
            this.tileGridOverlayUpdateRaf = null;
        }
        if (this.tileGridOverlayDataRefreshTimer !== null) {
            clearTimeout(this.tileGridOverlayDataRefreshTimer);
            this.tileGridOverlayDataRefreshTimer = null;
        }
    }

    /** Rebuilds the independent line grid and data-derived tile-state overlays. */
    private updateTileGridOverlay(): void {
        this.frame = this.readFrame();
        if (!this.frame) {
            this.removeTileGridLayers();
            this.removeTileStateLayers();
            return;
        }
        const viewport = this.frame.viewport;
        const layerLevels = this.visibleMapLayerLevels();
        if (layerLevels.length) {
            this.updateTileStateOverlays(layerLevels, viewport);
        } else {
            this.removeTileStateLayers();
        }
        const effectiveGridLevel = this.frame!.autoLevel
            ? autoTileGridLevel(
                this.frame!.altitude,
                this.frame!.mode
            )
            : coarsenedTileLevel(
                this.frame!.level,
                viewport,
                DeckTileOverlay.TILE_GRID_MAX_VISIBLE_CELLS,
                this.frame!.mode
            );
        this.updateTileGridLayers([effectiveGridLevel], viewport);
    }

    /** Reconciles the line-only grid overlay layers for the requested levels. */
    private updateTileGridLayers(levels: number[], viewport: Viewport): void {
        const nextLayerKeys = new Set<string>();
        levels.forEach((level, index) => {
            const layerKey = `${DeckTileOverlay.TILE_GRID_LAYER_KEY}/${level}`;
            const layer = this.createTileGridLayer(level, viewport, layerKey);
            this.layerRegistry.upsert(layerKey, layer, 325 + index);
            nextLayerKeys.add(layerKey);
        });
        for (const key of this.tileGridLayerKeys) {
            if (!nextLayerKeys.has(key)) {
                this.layerRegistry.remove(key);
            }
        }
        this.tileGridLayerKeys = nextLayerKeys;
    }

    /** Creates one shader-driven tile-grid line layer for a specific level. */
    private createTileGridLayer(level: number, viewport: Viewport, layerId: string): TileGridOverlayLayer {
        const overlayGeometry = this.tileGridOverlayGeometry(level, viewport);
        return new TileGridOverlayLayer({
            id: layerId,
            data: overlayGeometry.data,
            getPolygon: (datum: TileGridOverlayDatum) => datum.polygon,
            getFillColor: [0, 0, 0, 0],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            filled: true,
            extruded: false,
            // Keep the overlay quad in unwrapped longitude space. The shader
            // already works with unwrapped/projection-space X coordinates.
            wrapLongitude: false,
            pickable: false,
            gridMode: this.frame!.mode,
            localMin: overlayGeometry.localMin,
            localSize: overlayGeometry.localSize,
            subdivisionX: overlayGeometry.subdivisionX,
            subdivisionY: overlayGeometry.subdivisionY,
            lineColor: this.frame!.lineColor,
            lineWidthPixels: DeckTileOverlay.TILE_GRID_LINE_WIDTH_PX,
            parameters: DECK_OVERLAY_PARAMETERS
        });
    }

    /** Rebuilds the raster tile-state overlays that color error/empty cells behind the grid lines. */
    private updateTileStateOverlays(
        levels: number[],
        viewport: Viewport
    ): void {
        const visibleLayersByLevel = this.visibleMapLayersByLevel(levels);
        const nextLayerKeys = new Set<string>();
        const tileLimitPerView = this.frame!.tileLimit;
        for (const level of levels) {
            if (tileGridVisibleCellCount(level, viewport, this.frame!.mode) >
                DeckTileOverlay.TILE_GRID_MAX_VISIBLE_CELLS) {
                continue;
            }
            const visibleLayers = visibleLayersByLevel.get(level) ?? [];
            if (!visibleLayers.length) {
                continue;
            }
            const extent = tileGridExtentForLevel(level, viewport, this.frame!.mode);
            if (!extent) {
                continue;
            }

            const pixels = new Uint8ClampedArray(extent.width * extent.height * 4);
            const visibleTileIds = coreLib.getTileIds(viewport, level, tileLimitPerView) as number[];
            for (const tileId of visibleTileIds) {
                const stateKind = this.tileStateKindForTile(tileId, visibleLayers);
                if (stateKind === 0) {
                    continue;
                }
                const cell = this.tileGridCellForTile(tileId, extent);
                if (!cell) {
                    continue;
                }
                const pixelIndex = (cell.row * extent.width + cell.col) * 4;
                if (stateKind === TILE_STATE_KIND_ERROR) {
                    pixels[pixelIndex + 0] = DeckTileOverlay.TILE_STATE_ERROR_COLOR[0];
                    pixels[pixelIndex + 1] = DeckTileOverlay.TILE_STATE_ERROR_COLOR[1];
                    pixels[pixelIndex + 2] = DeckTileOverlay.TILE_STATE_ERROR_COLOR[2];
                    pixels[pixelIndex + 3] = DeckTileOverlay.TILE_STATE_ERROR_COLOR[3];
                } else if (stateKind === TILE_STATE_KIND_EMPTY) {
                    pixels[pixelIndex + 0] = DeckTileOverlay.TILE_STATE_EMPTY_COLOR[0];
                    pixels[pixelIndex + 1] = DeckTileOverlay.TILE_STATE_EMPTY_COLOR[1];
                    pixels[pixelIndex + 2] = DeckTileOverlay.TILE_STATE_EMPTY_COLOR[2];
                    pixels[pixelIndex + 3] = DeckTileOverlay.TILE_STATE_EMPTY_COLOR[3];
                }
            }

            const imageData = new ImageData(pixels, extent.width, extent.height);
            const layerKey = `${DeckTileOverlay.TILE_STATE_LAYER_KEY}/${level}`;
            const overlayGeometry = this.tileStateOverlayGeometry(extent);
            const layer = new TileGridStateOverlayLayer({
                id: layerKey,
                data: overlayGeometry.data,
                getPolygon: (datum: TileGridOverlayDatum) => datum.polygon,
                getFillColor: [255, 255, 255, 255],
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                filled: true,
                extruded: false,
                wrapLongitude: false,
                pickable: false,
                gridMode: this.frame!.mode,
                localMin: overlayGeometry.localMin,
                localSize: overlayGeometry.localSize,
                imageData,
                parameters: DECK_OVERLAY_PARAMETERS
            });
            this.layerRegistry.upsert(layerKey, layer, 300);
            nextLayerKeys.add(layerKey);
        }

        for (const key of this.tileStateLayerKeys) {
            if (!nextLayerKeys.has(key)) {
                this.layerRegistry.remove(key);
            }
        }
        this.tileStateLayerKeys = nextLayerKeys;
    }
    /** Return the distinct effective levels supplied by the renderer's visible-layer snapshot. */
    private visibleMapLayerLevels(): number[] {
        return [...new Set(this.frame!.layers.map(layer => layer.level))].sort((a, b) => a - b);
    }

    /** Group the immutable visibility snapshot without consulting application services again. */
    private visibleMapLayersByLevel(levels: number[]): Map<number, VisibleLayerRef[]> {
        const result = new Map(levels.map(level => [level, [] as VisibleLayerRef[]]));
        for (const layer of this.frame!.layers) result.get(layer.level)?.push(layer);
        return result;
    }

    /** Removes every tile-state overlay layer currently registered with deck. */
    private removeTileStateLayers(): void {
        for (const key of this.tileStateLayerKeys) {
            this.layerRegistry.remove(key);
        }
        this.tileStateLayerKeys.clear();
    }

    /** Removes every tile-grid line layer currently registered with deck. */
    private removeTileGridLayers(): void {
        for (const key of this.tileGridLayerKeys) {
            this.layerRegistry.remove(key);
        }
        this.tileGridLayerKeys.clear();
    }

    /** Classifies one tile cell as error, empty, or uncolored across every visible layer at that level. */
    private tileStateKindForTile(tileId: number, visibleLayers: VisibleLayerRef[]): number {
        switch (this.occupancyForTile(tileId, visibleLayers)) {
            case "error":
                return TILE_STATE_KIND_ERROR;
            case "empty":
                return TILE_STATE_KIND_EMPTY;
            default:
                return 0;
        }
    }

    /** Converts a tile id to its raster-cell coordinates inside the current tile-grid extent. */
    private tileGridCellForTile(tileId: number, extent: TileGridLevelExtent): { col: number; row: number } | null {
        const tileBox = coreLib.getTileBox(tileId) as unknown;
        if (!Array.isArray(tileBox) || tileBox.length < 4) {
            return null;
        }
        const west = Number(tileBox[0]);
        const north = Number(tileBox[3]);
        if (!Number.isFinite(west) || !Number.isFinite(north)) {
            return null;
        }
        const colNorm = tileGridLonToNormX(west);
        const rowNorm = tileGridLatToNormY(north, this.frame!.mode);
        const rawCol = Math.floor(colNorm * extent.colCount + 1e-9);
        const rawRow = Math.floor(rowNorm * extent.rowCount + 1e-9);
        const row = Math.max(0, Math.min(extent.rowCount - 1, rawRow));
        const col = wrapColumnIntoExtent(rawCol, extent);
        if (col < 0 || col >= extent.width) {
            return null;
        }
        const rowInExtent = row - extent.minRow;
        if (rowInExtent < 0 || rowInExtent >= extent.height) {
            return null;
        }
        return { col, row: rowInExtent };
    }

    /** Builds the geometry description for one tile-state overlay raster. */
    private tileStateOverlayGeometry(extent: TileGridLevelExtent): TileGridOverlayGeometry {
        const { localMin, localSize } = this.tileGridLocalBounds(extent);
        return {
            data: this.buildTileGridOverlayData(
                extent.west,
                extent.east,
                extent.south,
                extent.north,
                [extent.level],
                extent.coversFullWorldX
            ),
            localMin,
            localSize,
            subdivisionX: extent.width,
            subdivisionY: extent.height
        };
    }

    /** Builds the geometry description for one tile-grid line overlay level. */
    private tileGridOverlayGeometry(level: number, viewport: Viewport): TileGridOverlayGeometry {
        if (!viewport) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionX: 1,
                subdivisionY: 1
            };
        }
        const extent = tileGridExtentForLevel(level, viewport, this.frame!.mode);
        if (!extent) {
            return {
                data: tileGridOverlayData(),
                localMin: [0, 0],
                localSize: [1, 1],
                subdivisionX: 1,
                subdivisionY: 1
            };
        }
        const { localMin, localSize } = this.tileGridLocalBounds(extent);
        const rowsForLevel = Math.pow(2, Math.max(0, Math.min(22, level)));
        const colsForLevel = this.frame!.mode === "nds" ? rowsForLevel * 2 : rowsForLevel;
        return {
            data: this.buildTileGridOverlayData(
                extent.west,
                extent.east,
                extent.south,
                extent.north,
                [level],
                extent.coversFullWorldX
            ),
            localMin,
            localSize,
            subdivisionX: Math.max(1, Math.round(localSize[0] * colsForLevel)),
            subdivisionY: Math.max(1, Math.round(localSize[1] * rowsForLevel))
        };
    }

    /** Returns the local normalized bounds passed to the tile-grid shader modules. */
    private tileGridLocalBounds(extent: TileGridLevelExtent): { localMin: [number, number]; localSize: [number, number] } {
        return {
            localMin: [
                extent.minCol / extent.colCount,
                extent.minRow / extent.rowCount
            ],
            localSize: [
                Math.max(1e-6, (extent.maxCol - extent.minCol) / extent.colCount),
                Math.max(1e-6, (extent.maxRow - extent.minRow) / extent.rowCount)
            ]
        };
    }

    /**
     * Builds one or two overlay polygons covering the requested bounds.
     * Full-world extents remain split to avoid deck's unstable 360-degree LNGLAT primitive.
     */
    private buildTileGridOverlayData(
        west: number,
        east: number,
        south: number,
        north: number,
        levels: number[],
        coversFullWorldX: boolean
    ): TileGridOverlayDatum[] {
        const polygons = coversFullWorldX
            ? this.tileGridFullWorldPolygons(
                -180,
                180,
                south,
                north,
                this.tileGridFullWorldSplitLongitude(levels)
            )
            : [[
                [west, south],
                [west, north],
                [east, north],
                [east, south]
            ]] as [number, number][][];
        return polygons.map(polygon => ({ polygon }));
    }

    /**
     * A single 360-degree quad is unstable in deck's LNGLAT path. Split the
     * full-world overlay into two adjacent primitives and keep shader space continuous.
     */
    private tileGridFullWorldPolygons(
        west: number,
        east: number,
        south: number,
        north: number,
        splitLongitude: number
    ): [number, number][][] {
        return [
            [
                [west, south],
                [west, north],
                [splitLongitude, north],
                [splitLongitude, south]
            ],
            [
                [splitLongitude, south],
                [splitLongitude, north],
                [east, north],
                [east, south]
            ]
        ];
    }

    /**
     * Keep the full-world split seam away from all visible vertical grid lines.
     * Otherwise the seam itself can swallow one subdivision family.
     */
    private tileGridFullWorldSplitLongitude(levels: number[]): number {
        const finestLevel = levels.reduce(
            (maxLevel, level) => Math.max(maxLevel, Math.max(0, Math.min(22, Math.floor(level)))),
            0
        );
        const finestRowCount = Math.pow(2, finestLevel);
        const finestColCount = this.frame!.mode === "nds" ? finestRowCount * 2 : finestRowCount;
        const splitNormX = 0.5 + 0.5 / Math.max(2, finestColCount);
        return -180 + 360 * splitNormX;
    }
}
